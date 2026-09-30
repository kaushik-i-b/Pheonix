package com.fnb.corebank.repo;

import com.fnb.corebank.domain.Account;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AccountRepository extends JpaRepository<Account, Long> {

    List<Account> findAllByOrderByIdAsc();
}
